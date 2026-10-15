import path from "node:path";
import type { BrowserWindow } from "electron";
import { writeDiagnosticLog } from "./diagnostic-log";

/** Metadata only: never collect the page text, device list or conversation. */
export function installWorkspaceDiagnostics(window: BrowserWindow): void {
  const contents = window.webContents;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  contents.on("did-start-loading", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      if (contents.isDestroyed()) return;
      writeDiagnosticLog("error", "workspace", "workspace.load_timeout", "桌面页面加载超时，可从托盘重新加载界面", {
        document: documentName(contents.getURL()), loading: contents.isLoadingMainFrame()
      });
    }, 15000);
  });
  contents.on("did-stop-loading", () => clearTimeout(loadTimer));
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
    if (errorCode === -3) return; // An explicitly cancelled navigation.
    writeDiagnosticLog("error", "workspace", "workspace.load_failed", "桌面页面加载失败", {
      errorCode, errorDescription, document: documentName(url), isMainFrame
    });
  });
  contents.on("console-message", event => {
    if (event.level !== "error") return;
    writeDiagnosticLog("error", "workspace", "workspace.script_error", "桌面页面脚本报错", {
      message: event.message.slice(0, 1000), document: documentName(event.sourceId), line: event.lineNumber
    });
  });
  contents.on("did-finish-load", () => {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      if (contents.isDestroyed()) return;
      void contents.executeJavaScript(`({
        bridge: Boolean(window.profileManager),
        shell: Boolean(window.workspaceHost),
        navigation: Boolean(document.getElementById("workspace-rail")),
        ready: document.documentElement.dataset.workspaceShellReady === "true"
      })`).then(health => {
        const healthy = health?.bridge && health?.shell && health?.navigation && health?.ready;
        writeDiagnosticLog(healthy ? "info" : "error", "workspace", healthy ? "workspace.ready" : "workspace.not_ready",
          healthy ? "桌面主界面已就绪" : "桌面主界面未完成初始化", health);
      }).catch(error => writeDiagnosticLog("error", "workspace", "workspace.health_failed", "无法检查桌面主界面", { error }));
    }, 3000);
  });
  contents.once("destroyed", () => { clearTimeout(healthTimer); clearTimeout(loadTimer); });
}

function documentName(value: string): string {
  try { return path.posix.basename(new URL(value).pathname); }
  catch { return "unknown"; }
}
