import { promises as fs, watch, type FSWatcher } from "node:fs";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, Notification, screen, type IpcMainInvokeEvent, type Rectangle } from "electron";
import path from "node:path";
import { IPC_CHANNELS } from "../shared/ipc";
import type {
  AccountSyncDiffResult,
  AccountSyncRequest,
  AccountSyncResult,
  AgentOverlayRevealEvent,
  AgentTakeoverEvent,
  CloneProfilesRequest,
  CloneProfilesResult,
  RefreshClonesResult,
  RecycleIdleClonesResult,
  LaunchClonesResult,
  AppState,
  CancelOperationRequest,
  CdpLiveView,
  CdpLiveViewOptions,
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
  OperationProgressUpdate,
  PublicProfile,
  TakeoverAgentConnectionsRequest,
  TakeoverAgentConnectionsResponse
} from "../shared/types";
import { captureCdpLiveView } from "./cdp-live-view";
import { defaultDataDir } from "./fs-util";
import { ensureClaudeInstructionShell, readGlobalInstructions, writeGlobalInstruction } from "./global-instructions";
import { refreshAgentBrowserWrapperIfInstalled, setShellIntegrationEnabled } from "./shell-integration";
import { APP_TITLE, createProfileManager } from "./profile-manager";
import {
  ensureBrowserGatewayDaemon,
  browserGatewayRoot,
  subscribeBrowserGatewayEvents,
  type GatewayEventSubscription
} from "./browser-gateway-client";

const profileManager = createProfileManager(broadcastAgentTakeover, revealAgentOverlayProfile);
let agentOverlayDisposedForQuit = false;
let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let miniOutsideClickWindows: BrowserWindow[] = [];
let miniOutsideClickUpdateTimer: NodeJS.Timeout | null = null;
let miniWindowSaveTimer: NodeJS.Timeout | null = null;
// 主窗口失焦后延后判定“是否整个 App 退到后台”的定时器（防止内部换焦误触发）。
let mainWindowBlurTimer: NodeJS.Timeout | null = null;
const APP_ICON_PATH = path.join(__dirname, "../../public/assets/profilepilot-icon-512.png");
// 整个界面的统一缩放系数（等比例放大字号/间距/控件）。想再大/再小只改这一个数。
const UI_ZOOM_FACTOR = 1.0;
const MINI_DOCK_SIZE = 80;
// 一键唤起 / 聚焦 Mini 面板的全局快捷键（macOS = Cmd+Shift+P）
const MINI_SUMMON_SHORTCUT = "CommandOrControl+Shift+P";
// 直启置顶 profile 的全局快捷键：⌘⌥1~9 对应悬浮窗置顶列表的第 1~9 个。
// 用 Cmd+Alt+数字 而非裸 Cmd+数字，避免抢占浏览器/编辑器里「切到第 N 个标签页」，
// 也避开 ⌘⇧3/4/5 的 macOS 截图快捷键。
const QUICK_LAUNCH_SLOT_COUNT = 9;
// Gateway 事件负责实时更新；低频全量扫描只校准用户手动关闭浏览器、非 Gateway CDP 等外部变化。
const STATE_CALIBRATION_INTERVAL_MS = 30_000;
const QUICK_LAUNCH_ACCELERATOR = (slot: number): string => `CommandOrControl+Alt+${slot}`;
// 正在处理中的槽位启动，防同一 profile 被连按重复拉起。
const inFlightQuickLaunch = new Set<string>();
// 名字 + 端口▸域名 + 「工具名 已连接」现在同排展示，360 不够放，加宽到 440。
const MINI_PANEL_WIDTH = 440;
// 面板高度自适应内容：初始用这个值（约 3 行的常见高度，尽量贴近首屏避免首次展开跳一下），
// 渲染端量好真实内容高度后通过 resizeMiniPanel 精确调整。
const MINI_PANEL_HEIGHT = 210;
const MINI_PANEL_MIN_HEIGHT = 120;
const MINI_WINDOW_MARGIN = 16;
const activeOperations = new Map<string, ActiveOperation>();
let miniWindowPanelOpen = false;
// 面板固定：开启后点击面板外不再收成 logo（不建覆盖窗），只有点「收起」/Esc 才收。随窗口位置一起持久化。
let miniPanelPinned = false;
// 当前面板高度（自适应）；resizeMiniPanel 会更新它，并被 miniPanelBoundsFromDockBounds 使用。
let miniPanelHeight = MINI_PANEL_HEIGHT;
let miniWindowDragState: { offsetX: number; offsetY: number } | null = null;
let gatewayEventSubscription: GatewayEventSubscription | null = null;
let gatewayStateWatcher: FSWatcher | null = null;
let gatewayEventReconnectTimer: NodeJS.Timeout | null = null;
let stateCalibrationTimer: NodeJS.Timeout | null = null;
let stateBroadcastTimer: NodeJS.Timeout | null = null;
let stateBroadcastInFlight = false;
let stateBroadcastPending = false;
let stateCoordinatorStopping = false;

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

function broadcastAgentTakeover(takeover: AgentTakeoverEvent): void {
  for (const windowRef of [mainWindow, miniWindow]) {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.send(IPC_CHANNELS.agentTakeover, takeover);
    }
  }
  maybeShowAgentTakeoverNotification(takeover);
}

function broadcastAppState(state: AppState): void {
  for (const windowRef of [mainWindow, miniWindow]) {
    if (windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) {
      windowRef.webContents.send(IPC_CHANNELS.stateChanged, state);
    }
  }
}

function scheduleAppStateBroadcast(delayMs = 60): void {
  if (stateCoordinatorStopping) return;
  stateBroadcastPending = true;
  if (stateBroadcastTimer) return;
  stateBroadcastTimer = setTimeout(() => {
    stateBroadcastTimer = null;
    void refreshAndBroadcastAppState();
  }, delayMs);
}

async function refreshAndBroadcastAppState(): Promise<void> {
  if (stateCoordinatorStopping) return;
  if (stateBroadcastInFlight) {
    stateBroadcastPending = true;
    return;
  }
  stateBroadcastInFlight = true;
  stateBroadcastPending = false;
  try {
    broadcastAppState(await profileManager.getState());
  } catch (error) {
    console.warn(`[state-coordinator] 状态校准失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stateBroadcastInFlight = false;
    if (stateBroadcastPending) scheduleAppStateBroadcast(40);
  }
}

function connectGatewayEventStream(): void {
  if (stateCoordinatorStopping || gatewayEventSubscription) return;
  const subscription = subscribeBrowserGatewayEvents({
    onEvent: () => scheduleAppStateBroadcast(40),
    onDisconnect: () => {
      if (gatewayEventSubscription === subscription) gatewayEventSubscription = null;
      scheduleGatewayEventReconnect();
    }
  });
  gatewayEventSubscription = subscription;
  void subscription.ready.catch((error) => {
    console.warn(`[state-coordinator] Gateway 事件订阅失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

function scheduleGatewayEventReconnect(delayMs = 1_000): void {
  if (stateCoordinatorStopping || gatewayEventReconnectTimer) return;
  gatewayEventReconnectTimer = setTimeout(() => {
    gatewayEventReconnectTimer = null;
    void ensureBrowserGatewayDaemon()
      .then((status) => {
        if (status.protocolUpgradeDeferred === true) {
          scheduleGatewayEventReconnect(STATE_CALIBRATION_INTERVAL_MS);
          return;
        }
        connectGatewayEventStream();
      })
      .catch(() => scheduleGatewayEventReconnect());
  }, delayMs);
}

function startStateCoordinator(): void {
  stateCoordinatorStopping = false;
  startGatewayStateWatcher();
  scheduleGatewayEventReconnect(0);
  if (!stateCalibrationTimer) {
    stateCalibrationTimer = setInterval(
      () => scheduleAppStateBroadcast(0),
      STATE_CALIBRATION_INTERVAL_MS
    );
  }
}

function startGatewayStateWatcher(): void {
  if (stateCoordinatorStopping || gatewayStateWatcher) return;
  try {
    gatewayStateWatcher = watch(browserGatewayRoot(), { persistent: false }, (_eventType, filename) => {
      if (!filename || String(filename).includes("state.json")) {
        scheduleAppStateBroadcast(40);
      }
    });
    gatewayStateWatcher.once("error", () => {
      gatewayStateWatcher?.close();
      gatewayStateWatcher = null;
    });
  } catch {
    // Gateway 目录尚未创建时由控制流订阅/30 秒校准兜底。
  }
}

function stopStateCoordinator(): void {
  stateCoordinatorStopping = true;
  gatewayEventSubscription?.close();
  gatewayEventSubscription = null;
  gatewayStateWatcher?.close();
  gatewayStateWatcher = null;
  if (gatewayEventReconnectTimer) clearTimeout(gatewayEventReconnectTimer);
  if (stateCalibrationTimer) clearInterval(stateCalibrationTimer);
  if (stateBroadcastTimer) clearTimeout(stateBroadcastTimer);
  gatewayEventReconnectTimer = null;
  stateCalibrationTimer = null;
  stateBroadcastTimer = null;
  stateBroadcastPending = false;
}

function maybeShowAgentTakeoverNotification(takeover: AgentTakeoverEvent): void {
  // Mini 可见时它已经会展示接管状态；这里跳过系统通知，避免同一接管动作双重提醒。
  if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()) {
    return;
  }
  if (!Notification.isSupported()) {
    return;
  }

  const agent = takeover.agent || "AI";
  const session = takeover.sessionTitle || takeover.session || "未命名会话";
  try {
    const notification = new Notification({
      title: `已接管 ${takeover.profileName}`,
      body: `${agent} · ${session}`,
      icon: APP_ICON_PATH,
      silent: true
    });
    notification.on("click", () => {
      void showMainWindow();
    });
    notification.show();
  } catch {
    // 通知权限未授予、系统不支持或当前环境禁用时静默跳过。
  }
}

function revealAgentOverlayProfile(reveal: AgentOverlayRevealEvent): void {
  void showMainWindow().then(() => {
    const windowRef = mainWindow;
    if (!windowRef || windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) {
      return;
    }

    const send = (): void => {
      if (!windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) {
        windowRef.webContents.send(IPC_CHANNELS.agentOverlayReveal, reveal);
      }
    };

    if (windowRef.webContents.isLoading()) {
      windowRef.webContents.once("did-finish-load", () => setTimeout(send, 0));
      return;
    }
    send();
  });
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
  panelPinned?: boolean;
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

function clampMiniPanelHeight(height: number, dockBounds: Rectangle): number {
  const workArea = screen.getDisplayMatching(dockBounds).workArea;
  const maxHeight = workArea.height - MINI_WINDOW_MARGIN * 2;
  return Math.round(clamp(height, MINI_PANEL_MIN_HEIGHT, maxHeight));
}

function miniPanelBoundsFromDockBounds(dockBounds: Rectangle): Rectangle {
  const height = clampMiniPanelHeight(miniPanelHeight, dockBounds);
  const candidate = {
    x: dockBounds.x - (MINI_PANEL_WIDTH - MINI_DOCK_SIZE),
    y: dockBounds.y,
    width: MINI_PANEL_WIDTH,
    height
  };
  const workArea = screen.getDisplayMatching(dockBounds).workArea;
  return {
    x: clamp(candidate.x, workArea.x, workArea.x + workArea.width - MINI_PANEL_WIDTH),
    y: clamp(candidate.y, workArea.y, workArea.y + workArea.height - height),
    width: MINI_PANEL_WIDTH,
    height
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

  // 层级说明：floating 盖不住原生全屏 Space（skipTransformProcessType 保住 Dock 图标后，
  // App 是普通 Foreground 类型，floating 级窗口会被全屏 Space 挡掉）；screen-saver 层级
  // 足够高，配合 FullScreenAuxiliary 集合行为可以浮在全屏 App 之上。
  // 不用 "pop-up-menu"：之前实测它会把整个 App 变成 UIElement（无 Dock 图标）。
  windowRef.setAlwaysOnTop(true, "screen-saver");
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
  // 面板固定时点外面不收起（此时本不该有覆盖窗，这里兜底）。
  if (miniPanelPinned) {
    return;
  }
  if (miniWindowPanelOpen) {
    notifyMiniWindowPanelOpen(false);
  }
}

function notifyMiniPanelPinned(): void {
  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed() || windowRef.webContents.isDestroyed()) {
    return;
  }

  windowRef.webContents.send(IPC_CHANNELS.miniPanelPinnedChanged, miniPanelPinned);
}

function setMiniPanelPinned(pinned: boolean): void {
  if (miniPanelPinned === pinned) {
    notifyMiniPanelPinned();
    return;
  }

  miniPanelPinned = pinned;
  notifyMiniPanelPinned();
  // 固定 → 撤掉全屏覆盖窗（否则会吃掉点面板外的第一下点击）；取消固定 → 恢复覆盖窗。
  if (miniWindowPanelOpen) {
    if (pinned) {
      closeMiniOutsideClickWindows();
    } else {
      scheduleMiniOutsideClickWindowsUpdate();
    }
  }
  const windowRef = miniWindow;
  if (windowRef && !windowRef.isDestroyed()) {
    void saveMiniWindowBounds(miniDockBoundsFromWindowBounds(windowRef.getBounds()));
  }
}

function showMiniOutsideClickWindows(): void {
  const windowRef = miniWindow;
  closeMiniOutsideClickWindows();
  if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible() || !miniWindowPanelOpen || miniPanelPinned) {
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
  const overlays = miniOutsideClickBounds(windowRef.getBounds()).map((bounds) => {
    const overlayWindow = new BrowserWindow({
      ...bounds,
      // 同悬浮窗：面板类型才能盖住原生全屏 Space（见 createMiniWindow 说明）。
      type: "panel",
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

    // 覆盖窗要垫在悬浮窗（screen-saver 层）之下、又要盖住全屏 App，跟随同一层级。
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    // 与悬浮窗一致：全屏 App 下也要能盖住，否则展开面板后「点外面收起」在全屏 Space 里失效。
    // skipTransformProcessType 同悬浮窗：避免 App 被切成 UIElement 丢掉 Dock 图标。
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    overlayWindow.on("closed", () => {
      miniOutsideClickWindows = miniOutsideClickWindows.filter((item) => item !== overlayWindow);
    });

    return overlayWindow;
  });
  miniOutsideClickWindows = overlays;

  // 先把 4 个覆盖窗都加载+显示（showInactive 不抢焦点），全部就绪后再把悬浮窗 raise 一次。
  // 之前是每个覆盖窗各 raise/focus 一次（共 4 次）→ 第一次展开会闪好几下。
  void Promise.all(
    overlays.map((overlayWindow) =>
      overlayWindow
        .loadURL(overlayUrl)
        .then(() => {
          if (!overlayWindow.isDestroyed()) {
            overlayWindow.showInactive();
          }
        })
        .catch(() => {
          // 覆盖窗是尽力而为，加载失败不影响主流程。
        })
    )
  ).then(() => {
    if (windowRef && !windowRef.isDestroyed()) {
      raiseMiniWindow(windowRef);
    }
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
      return { x: Number(parsed.x), y: Number(parsed.y), dock: parsed.dock === true, panelPinned: parsed.panelPinned === true };
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
    `${JSON.stringify({ x: Math.round(bounds.x), y: Math.round(bounds.y), dock: true, panelPinned: miniPanelPinned }, null, 2)}\n`,
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

  const savedPosition = await readMiniWindowPosition();
  miniPanelPinned = savedPosition?.panelPinned === true;
  const bounds = normalizeMiniWindowDockBounds(savedPosition);
  miniWindow = new BrowserWindow({
    ...bounds,
    // NSPanel：普通 Dock 应用的常规窗口无论层级多高都盖不住别人的原生全屏 Space，
    // 只有面板类窗口（Spotlight/Raycast 同款）可以，且不需要把 App 降级成无 Dock 图标的 Accessory。
    type: "panel",
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
  // visibleOnFullScreen：让悬浮窗也能浮在「原生全屏 App（绿色按钮，独占一个 Space）」之上，
  // 否则用户全屏某个软件时悬浮窗就看不见了。层级仍用 "floating"（见 raiseMiniWindow 说明）。
  // skipTransformProcessType：Electron 默认实现 visibleOnFullScreen 时会把整个 App 切成
  // Accessory（UIElement），导致 Dock 图标消失；其实窗口只需要 FullScreenAuxiliary 集合行为，
  // 跳过进程类型转换即可保住 Dock 图标。
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  miniWindow.webContents.on("did-finish-load", () => {
    notifyMiniWindowPanelOpen(miniWindowPanelOpen);
    notifyMiniPanelPinned();
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
      raiseMiniWindow(windowRef);
      // 覆盖窗较重（4 个全屏窗口），延后创建，避免阻塞面板展开造成卡顿。
      scheduleMiniOutsideClickWindowsUpdate();
    } else {
      // 关闭 4 个全屏覆盖窗较慢（~100ms），同步执行会拖住本次 IPC 返回，
      // 让渲染端迟迟渲染不出 dock（窗口已缩小却空着 → 卡顿）。延后关闭即可。
      setImmediate(closeMiniOutsideClickWindows);
    }
    return;
  }

  const dockBounds = miniDockBoundsFromWindowBounds(currentBounds);
  miniWindowPanelOpen = open;
  windowRef.setBounds(open ? miniPanelBoundsFromDockBounds(dockBounds) : normalizeMiniWindowDockBounds(dockBounds), false);
  notifyMiniWindowPanelOpen(open);
  if (open) {
    raiseMiniWindow(windowRef);
    // 覆盖窗较重（4 个全屏窗口），延后创建，避免阻塞面板展开造成卡顿。
    scheduleMiniOutsideClickWindowsUpdate();
  } else {
    // 同上：延后关闭覆盖窗，避免阻塞 IPC 返回导致收起后 dock 迟迟不出现。
    setImmediate(closeMiniOutsideClickWindows);
  }
  void saveMiniWindowBounds(dockBounds);
}

// 渲染端量好面板内容真实高度后调用：把窗口高度调成内容高度（封顶到屏幕可用高度，超出则内部滚动）。
function resizeMiniPanel(height: number): void {
  if (!Number.isFinite(height)) {
    return;
  }

  const windowRef = miniWindow;
  if (!windowRef || windowRef.isDestroyed() || !miniWindowPanelOpen) {
    // 面板未开时先记下期望高度，下次展开即用。
    miniPanelHeight = height;
    return;
  }

  const currentBounds = windowRef.getBounds();
  const workArea = screen.getDisplayMatching(currentBounds).workArea;
  const clamped = clampMiniPanelHeight(height, currentBounds);
  miniPanelHeight = clamped;
  if (currentBounds.height === clamped) {
    return;
  }

  // 保持当前 x/y（顶部锚点不动），只改高度；y 需保证面板仍在工作区内。
  const y = clamp(currentBounds.y, workArea.y, workArea.y + workArea.height - clamped);
  windowRef.setBounds({ x: currentBounds.x, y, width: MINI_PANEL_WIDTH, height: clamped }, false);
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

// focus=false：收成悬浮窗但不抢焦点（用于“切到别的 App / 切 Space”这类被动退后台场景，
// 否则会把焦点从用户刚切过去的窗口（如 Chrome 副本）夺回来）。
async function showMiniWindow(options?: { focus?: boolean }): Promise<void> {
  const focusMini = options?.focus !== false;
  const windowRef = await createMiniWindow();
  setMiniWindowPanelOpen(false);
  await waitForMiniWindowFirstPaint(windowRef, ".mini-logo-glyph");
  if (focusMini) {
    windowRef.show();
    raiseMiniWindow(windowRef);
    windowRef.focus();
  } else {
    windowRef.showInactive();
    raiseMiniWindow(windowRef);
  }
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

// 全局快捷键触发：直启（或已运行则前置显示）指派到第 slot 个槽位的 profile。
// 槽位映射是用户在主窗口「更多」菜单里显式指派的（PublicProfile.quickLaunchSlot）。
// 动作与悬浮窗卡片主按钮一致：运行中→显示；独立且固定端口→CDP 启动；否则普通启动。
async function quickLaunchProfileBySlot(slot: number): Promise<void> {
  let profile: PublicProfile | null = null;
  try {
    const state = await profileManager.getState();
    profile = (state.profiles || []).find((item) => item.quickLaunchSlot === slot) || null;
  } catch (error) {
    console.warn(`[quick-launch] 读取状态失败（槽位 ${slot}）：`, error);
    return;
  }

  if (!profile) {
    notifyQuickLaunch("没有可直启的 Profile", `快捷键 ⌘⌥${slot} 还没有绑定 Profile，可在主窗口「更多」菜单里指派。`);
    return;
  }

  if (inFlightQuickLaunch.has(profile.id)) {
    return;
  }
  inFlightQuickLaunch.add(profile.id);
  try {
    if (profile.running) {
      await profileManager.focusProfile(profile.id);
    } else if (profile.source === "isolated" && profile.fixedCdpPort) {
      await profileManager.launchProfileWithCdp(profile.id, profile.fixedCdpPort);
    } else {
      await profileManager.launchProfile(profile.id);
    }
  } catch (error) {
    console.warn(`[quick-launch] 槽位 ${slot}（${profile.name}）启动失败：`, error);
    notifyQuickLaunch("直启失败", `${profile.name}：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    inFlightQuickLaunch.delete(profile.id);
  }
}

// 直启无对应 profile / 失败时的轻量原生提示（App 可能在后台，用户看不到窗口内 toast）。
function notifyQuickLaunch(title: string, body: string): void {
  if (!Notification.isSupported()) {
    console.warn(`[quick-launch] ${title} — ${body}`);
    return;
  }
  new Notification({ title, body, silent: true }).show();
}

function registerGlobalShortcuts(): void {
  globalShortcut.unregister(MINI_SUMMON_SHORTCUT);
  const registered = globalShortcut.register(MINI_SUMMON_SHORTCUT, () => {
    void summonMiniWindowViaHotkey();
  });
  if (!registered) {
    console.warn(`[mini] 全局快捷键注册失败（可能被占用）：${MINI_SUMMON_SHORTCUT}`);
  }

  for (let slot = 1; slot <= QUICK_LAUNCH_SLOT_COUNT; slot += 1) {
    const accelerator = QUICK_LAUNCH_ACCELERATOR(slot);
    globalShortcut.unregister(accelerator);
    const ok = globalShortcut.register(accelerator, () => {
      void quickLaunchProfileBySlot(slot);
    });
    if (!ok) {
      console.warn(`[quick-launch] 全局快捷键注册失败（可能被占用）：${accelerator}`);
    }
  }
}

async function showMainWindow(): Promise<void> {
  if (mainWindowBlurTimer) {
    clearTimeout(mainWindowBlurTimer);
    mainWindowBlurTimer = null;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  // 收成悬浮窗时主窗口可能仍带着最小化标记（minimize 事件里只 hide 没 restore），
  // 恢复前先 restore 清掉，避免 show() 后窗口仍处于最小化态。
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  // “展开”、Dock 激活和 second-instance 都是用户明确要求打开主控制台。
  // BrowserWindow.show/focus 只能处理窗口自身；若 App 曾通过 `open -j` 隐藏启动，
  // macOS 的应用级 hidden/activation 状态仍会把窗口压在后台。因此先解除隐藏并激活 App，
  // 再把窗口抬到当前桌面的最前面。被动失焦收成悬浮窗不会走这里，仍不会抢用户焦点。
  if (process.platform === "darwin") {
    app.show();
    app.focus({ steal: true });
  }
  mainWindow?.show();
  mainWindow?.moveTop();
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
                  accountSyncDiffButton: document.querySelector('[data-action="scan-account-diff"]')?.textContent?.trim() || null,
                  extensionScanButton: document.querySelector('[data-action="scan-extensions"]')?.textContent?.trim() || null,
                  accountConfirmTitle: null,
                  accountConfirmButton: null,
                  accountConfirmSummary: [],
                  migrationTitle: document.querySelector("[data-extension-migration] strong")?.textContent || null,
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
                const syncAccountButton = document.querySelector('[data-action="run-sync"]');
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

  // 点最小化（黄色按钮）不缩进 Dock，而是收成悬浮窗：只 hide()，绝不 restore()。
  mainWindow.on("minimize", () => {
    const windowRef = mainWindow;
    if (!windowRef || windowRef.isDestroyed()) {
      return;
    }

    windowRef.hide();
    void showMiniWindow();
  });

  // 很多人不点最小化，而是「点屏幕别处 / 四本指切 Space」把窗口放到后台——这不会触发 minimize，
  // 悬浮窗就出不来。这里补上：主窗口在前台可见时失焦，稍等片刻若整个 App 都没有窗口在聚焦
  // （= 切到别的 App 或切了 Space，而不是内部换焦），就同样收成悬浮窗（不抢焦点）。
  mainWindow.on("blur", () => {
    const windowRef = mainWindow;
    if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible() || windowRef.isMinimized()) {
      return;
    }

    if (mainWindowBlurTimer) {
      clearTimeout(mainWindowBlurTimer);
    }
    mainWindowBlurTimer = setTimeout(() => {
      mainWindowBlurTimer = null;
      const ref = mainWindow;
      if (!ref || ref.isDestroyed() || !ref.isVisible() || ref.isMinimized()) {
        return;
      }
      // 本 App 仍有任意窗口聚焦 → 只是内部换焦（开 DevTools、悬浮窗展开重排等），不处理。
      if (BrowserWindow.getFocusedWindow()) {
        return;
      }
      void showMiniWindow({ focus: false });
    }, 150);
  });

  mainWindow.loadFile(path.join(__dirname, "../../public/index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getState, async (): Promise<AppState> => profileManager.getState());
  ipcMain.handle(IPC_CHANNELS.getTakeoverHistory, async (): Promise<AgentTakeoverEvent[]> => profileManager.getTakeoverHistory());

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

  ipcMain.handle(IPC_CHANNELS.setMiniProfilePinned, async (_event, id: string, pinned: boolean): Promise<AppState> => {
    await profileManager.setMiniProfilePinned(id, Boolean(pinned));
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.setMiniProfileOrder, async (_event, ids: string[]): Promise<AppState> => {
    await profileManager.setMiniProfileOrder(Array.isArray(ids) ? ids : []);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.setMainProfileOrder, async (_event, ids: string[]): Promise<AppState> => {
    await profileManager.setMainProfileOrder(Array.isArray(ids) ? ids : []);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.setQuickLaunchSlot, async (_event, id: string, slot: number | null): Promise<AppState> => {
    await profileManager.setQuickLaunchSlot(id, slot ?? null);
    return profileManager.getState();
  });

  ipcMain.handle(IPC_CHANNELS.setMiniPanelPinned, async (_event, pinned: boolean): Promise<void> => {
    setMiniPanelPinned(Boolean(pinned));
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

  ipcMain.handle(IPC_CHANNELS.resizeMiniPanel, async (_event, height: number): Promise<void> => {
    resizeMiniPanel(Number(height));
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

  ipcMain.handle(IPC_CHANNELS.setShellIntegrationEnabled, async (_event, enabled: boolean): Promise<AppState> => {
    await setShellIntegrationEnabled(Boolean(enabled));
    return profileManager.getState();
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

  ipcMain.handle(IPC_CHANNELS.disconnectCdpClient, async (_event, profileId: string, pid: number): Promise<AppState> => {
    await profileManager.disconnectCdpClient(profileId, pid);
    return profileManager.getState();
  });

  ipcMain.handle(
    IPC_CHANNELS.takeoverAgentConnections,
    async (
      _event,
      profileId: string,
      sessionOrOptions?: string | TakeoverAgentConnectionsRequest
    ): Promise<TakeoverAgentConnectionsResponse> => {
      const result = await profileManager.takeoverAgentConnections(profileId, sessionOrOptions);
      return {
        ...result,
        state: await profileManager.getState()
      };
    }
  );

  ipcMain.handle(IPC_CHANNELS.setAgentOverlayEnabled, async (_event, enabled: boolean): Promise<AppState> => {
    await profileManager.setAgentOverlayEnabled(Boolean(enabled));
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

  ipcMain.handle(IPC_CHANNELS.cloneProfiles, async (event, request: CloneProfilesRequest): Promise<CloneProfilesResult> => {
    const id = operationId("clone-profiles");
    const controller = new AbortController();
    const pause = new OperationPauseController();
    activeOperations.set(id, { controller, pause });

    try {
      return await profileManager.cloneProfiles(
        request,
        createProgressReporter(event, { key: "clone-profiles" }),
        controller.signal,
        pause
      );
    } finally {
      activeOperations.delete(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.refreshClones, async (event, sourceProfileId: string): Promise<RefreshClonesResult> => {
    const id = operationId("refresh-clones");
    const controller = new AbortController();
    const pause = new OperationPauseController();
    activeOperations.set(id, { controller, pause });

    try {
      return await profileManager.refreshClones(
        sourceProfileId,
        createProgressReporter(event, { key: "refresh-clones" }),
        controller.signal,
        pause
      );
    } finally {
      activeOperations.delete(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.resetClone, async (event, profileId: string): Promise<AccountSyncResult> => {
    const id = operationId("reset-clone", profileId);
    const controller = new AbortController();
    const pause = new OperationPauseController();
    activeOperations.set(id, { controller, pause });

    try {
      return await profileManager.resetClone(
        profileId,
        createProgressReporter(event, { key: "reset-clone", profileId }),
        controller.signal,
        pause
      );
    } finally {
      activeOperations.delete(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.launchClones, async (event, sourceProfileId: string): Promise<LaunchClonesResult> => {
    return profileManager.launchClones(sourceProfileId, createProgressReporter(event, { key: "launch-clones" }));
  });

  ipcMain.handle(IPC_CHANNELS.recycleIdleClones, async (_event, days: number): Promise<RecycleIdleClonesResult> => {
    return profileManager.recycleIdleClones(days);
  });

  ipcMain.handle(IPC_CHANNELS.setProfileTag, async (_event, profileId: string, tag: string): Promise<AppState> => {
    await profileManager.setProfileTag(profileId, tag);
    return profileManager.getState();
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

  // 实时观测：按端口抓一份当前标签页 + 主标签截图。无状态、按需调用，不进全局 getState 轮询。
  ipcMain.handle(
    IPC_CHANNELS.getCdpLiveView,
    async (_event, port: number, options?: CdpLiveViewOptions): Promise<CdpLiveView> =>
      captureCdpLiveView(Number(port), options || {})
  );

}

app.name = APP_TITLE;
app.setName(APP_TITLE);

// 单实例锁：双实例会各自对 live CDP 端口挂观察连接、互相把对方当成“驱动工具”，
// 还会同时写 registry。第二个实例直接退出，把已有实例的主窗口拉到前台。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void showMainWindow();
  });
}

app.whenReady().then(async () => {
  await ensureBrowserGatewayDaemon().catch((error) => {
    console.error(`[browser-gateway] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  });
  await refreshAgentBrowserWrapperIfInstalled().catch((error) => {
    console.warn(`[shell-integration] 刷新 agent-browser wrapper 失败：${error instanceof Error ? error.message : String(error)}`);
  });

  if (process.platform === "darwin") {
    app.dock?.setIcon(APP_ICON_PATH);
  }

  registerIpcHandlers();
  registerGlobalShortcuts();
  createMainWindow();
  startStateCoordinator();

  // 点击 Dock 图标：始终把主控制台拉回来（必要时重建），并收起悬浮窗。
  // 覆盖“主窗口已关闭、只剩悬浮窗”的情况——此时旧逻辑会因为还有窗口而什么都不做。
  app.on("activate", () => {
    // 若这次激活来自点击悬浮窗本身（App 在后台时点小球 → 光标落在悬浮窗内），
    // 交给悬浮窗自己展开面板，不要抢回主窗口，否则一点小球就变回大窗口。
    if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible() && isMiniWindowPointerInside()) {
      raiseMiniWindow(miniWindow);
      return;
    }
    void showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  stopStateCoordinator();
  if (agentOverlayDisposedForQuit) {
    return;
  }
  agentOverlayDisposedForQuit = true;
  event.preventDefault();
  void profileManager.disposeAgentOverlay().finally(() => {
    app.quit();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
