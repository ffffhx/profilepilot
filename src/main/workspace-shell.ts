import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";
import { workspaceRoute } from "../shared/workspaces";
import { IPC_CHANNELS } from "../shared/ipc";

export function isWorkspaceShell(url: string, publicDir = path.resolve(__dirname, "../../public")): boolean {
  try { return path.resolve(fileURLToPath(new URL(url))) === path.join(publicDir, "workspace.html"); }
  catch { return false; }
}

export function protectWorkspaceShell(window: BrowserWindow): void {
  const base = pathToFileURL(path.resolve(__dirname, "../../public/workspace.html")).href;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-frame-navigate", event => {
    // Only the five packaged documents may occupy the shell's content frames.
    // IPC stays in the trusted main frame; web pages never receive a bridge.
    const target = workspaceRoute(event.url, base);
    if (event.isMainFrame || !target) { event.preventDefault(); return; }
    const current = workspaceRoute(event.frame?.url || "", base);
    if (current && current.id !== target.id) {
      event.preventDefault();
      window.webContents.send(IPC_CHANNELS.navigateWorkspace, event.url);
    }
  });
}
