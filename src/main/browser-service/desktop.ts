import { BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BROWSER_CONNECTION_CHANNEL, BROWSER_CONNECTION_CHANGED, type BrowserConnectionSnapshot } from "../../shared/browser-connection";
import { defaultDataDir } from "../fs-util";
import type { ProfileManager } from "../profile-manager";
import { isWorkspaceShell } from "../workspace-shell";
import { BrowserServiceClient } from "./client";
import { browserServiceLaunchInfo, saveBrowserServiceLaunch } from "./launcher";

/** The desktop owns the connection. Tasks subscribe as a consumer and may fail
 * or stop without taking down connection settings, live view, or CLI sessions. */
export function registerBrowserConnection(
  profiles: ProfileManager,
  canPair: (profileId: string) => boolean = () => true
): BrowserServiceClient {
  // Keep the existing location so upgrades retain pairing and service identity.
  const root = path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "browser-tasks");
  saveBrowserServiceLaunch(root, browserServiceLaunchInfo(path.resolve(__dirname, "../../..")));
  const client = new BrowserServiceClient(root, () => broadcast());
  const snapshot = (): BrowserConnectionSnapshot => ({
    nativeBrowsers: client.states(), nativeInstallations: client.installationStates()
  });
  const broadcast = (): void => {
    const value = snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(BROWSER_CONNECTION_CHANGED, value);
    }
  };
  ipcMain.handle(BROWSER_CONNECTION_CHANNEL, async (event, method: string, ...args: unknown[]) => {
    const url = event.senderFrame?.url || "";
    const publicDir = path.resolve(__dirname, "../../../public");
    let source: string;
    try { source = fileURLToPath(new URL(url)); }
    catch { throw new Error("浏览器连接接口只能由本地桌面界面调用。"); }
    const shellFrame = isWorkspaceShell(url, publicDir) && event.senderFrame === event.sender?.mainFrame;
    if (!shellFrame && !["index.html", "tools.html", "tasks.html"].some(name => path.resolve(source) === path.join(publicDir, name))) {
      throw new Error("不允许此页面调用浏览器连接接口。");
    }
    if (method === "snapshot") return snapshot();
    if (method === "openNativeExtensionFolder") return client.revealExtension();
    const id = z.string().min(1).max(150).parse(args[0]);
    if (method === "getNativeLiveView") {
      z.string().regex(/^native:[^/\\]{1,100}$/).parse(id);
      const state = client.states().find(item => item.profileId === id);
      if (!state?.connected) throw new Error("请先到配套工具连接浏览器扩展。");
      if (!state.capabilities?.includes("liveView")) throw new Error("请在配套工具中更新浏览器扩展后查看实时画面。");
      return client.request(id, "liveView", {}, 5000);
    }
    const profile = (await profiles.getState()).profiles.find(p => p.id === id && p.source === "native");
    if (!profile) throw new Error("请选择本机已发现的系统 Chrome Profile。");
    if (method === "authorizeNativeBrowser" || method === "pairNativeBrowser") {
      if (!canPair(id)) throw new Error("请先暂停此 Profile 上的任务，再重新配对。");
      if (method === "pairNativeBrowser") return client.pair(id);
      const request = await client.authorize(id, profile.name);
      await profiles.launchProfileWithUrls(id, [request.url]);
      await client.beginInstallation(request.url);
      return { expiresAt: request.expiresAt };
    }
    if (method === "disconnectNativeBrowser") { await client.disconnect(id); broadcast(); return; }
    throw new Error("未知浏览器连接操作。");
  });
  if (existsSync(path.join(root, "native-browser-credentials.bin")) || existsSync(path.join(root, "native-control.json"))) {
    void client.start().catch(error => { console.error("浏览器服务连接失败：", error); broadcast(); });
  }
  return client;
}
