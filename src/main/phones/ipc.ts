import { BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isWorkspaceShell } from "../workspace-shell";
import { PHONE_CHANNEL, PHONE_CHANGED } from "../../shared/phones";
import { PhonesService } from "./service";
import { executePhoneCommand } from "./management";

export function registerPhones(root: string, apkPath: string, poll = true): PhonesService {
  const service = new PhonesService({ root, apkPath, onChanged: snapshot => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && trusted(window.webContents.getURL())) window.webContents.send(PHONE_CHANGED, snapshot);
  } });
  ipcMain.handle(PHONE_CHANNEL, async (event, method: string, params: unknown) => {
    const url = event.senderFrame?.url || "";
    if (event.senderFrame !== event.sender.mainFrame || !trusted(url)) throw new Error("手机接口仅供 ProfilePilot 工作区使用。");
    if (method === "snapshot") return service.snapshot();
    if (!trusted(url, true)) throw new Error("请在手机工作区操作设备。");
    return executePhoneCommand({ action: "phone", method, params }, service);
  });
  if (poll) service.startPolling(); return service;
}
function trusted(url: string, phonesOnly = false): boolean {
  if (isWorkspaceShell(url, path.resolve(__dirname, "../../../public"))) return true;
  try {
    const file = fileURLToPath(new URL(url));
    const allowed = phonesOnly ? ["phones.html"] : ["phones.html", "index.html", "tasks.html", "local-apps.html", "tools.html"];
    return allowed.some(name => path.resolve(file) === path.resolve(__dirname, "../../../public", name));
  } catch { return false; }
}
