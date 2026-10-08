import { BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceShell } from "../workspace-shell";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { MOBILE_CHANGED, MOBILE_CHANNEL } from "../../shared/mobile";
import type { ProfileManager } from "../profile-manager";
import type { TaskService } from "../tasks/service";
import { MobileService } from "./service";

export function registerMobile(root: string, tasks: TaskService, profiles: ProfileManager, apk: string): MobileService {
  const service = new MobileService({ root, tasks, profiles: async () => {
    const state = profiles.getCachedState() || await profiles.getInitialState();
    return state.profiles.map(profile => {
      const availability = tasks.profileAvailability(profile.id);
      return { id: profile.id, name: profile.name, source: profile.source, ready: !profile.agentAccessDisabled && availability?.ready !== false,
        reason: profile.agentAccessDisabled ? "此 Profile 已禁止 Agent 连接" : availability?.reason };
    });
  }, changed: snapshot => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && trusted(window.webContents.getURL())) window.webContents.send(MOBILE_CHANGED, snapshot);
  } });
  ipcMain.handle(MOBILE_CHANNEL, async (event, method: string, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame?.url || "")) throw new Error("请在 ProfilePilot 手机工作区管理移动版连接。");
    if (method === "snapshot") return service.snapshot();
    if (method === "configure") return service.configure(args[0]);
    if (method === "pair") return service.pair(typeof args[0] === "string" ? args[0] : undefined);
    if (method === "revoke") return service.revoke(String(args[0]));
    if (method === "updateDevice") return service.updateDevice(String(args[0]), args[1]);
    if (method === "openApkFolder") {
      if (!existsSync(apk)) throw new Error("尚未构建移动版安装包，请运行 npm run build:phone。");
      // Electron can read an APK inside app.asar; Explorer/Finder cannot.
      const folder = path.join(root, "downloads"); mkdirSync(folder, { recursive: true });
      const output = path.join(folder, "profilepilot-phone.apk"); copyFileSync(apk, output);
      shell.showItemInFolder(output); return;
    }
    throw new Error("未知移动版操作。");
  });
  void service.start().catch(() => {}); // A bind failure is visible in the workspace and must not block desktop startup.
  return service;
}
function trusted(url: string): boolean {
  if (isWorkspaceShell(url, path.resolve(__dirname, "../../../public"))) return true;
  try { return path.resolve(fileURLToPath(new URL(url))) === path.resolve(__dirname, "../../../public/phones.html"); }
  catch { return false; }
}
