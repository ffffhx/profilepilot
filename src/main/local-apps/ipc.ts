import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LOCAL_APPS_CHANNEL } from "../../shared/local-apps";
import { defaultDataDir } from "../fs-util";
import { LocalAppsService } from "./service";
import type { ProfileManager } from "../profile-manager";
import { LocalAppGateway, localAppProfileId } from "./gateway";

export function registerLocalApps(profileManager: ProfileManager): LocalAppsService {
  const gateway = process.env.CPM_ELECTRON_SMOKE_TEST !== "1" || process.env.CPM_E2E_LOCAL_APP_GATEWAY === "1" ? new LocalAppGateway() : undefined;
  const service = new LocalAppsService(path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "local-apps"), async () => {
    const state = await profileManager.getState();
    return new Set(state.profiles.flatMap(profile => [profile.fixedCdpPort, profile.cdpPort].filter((port): port is number => typeof port === "number")));
  }, gateway);
  const sync = () => { void service.syncAgents().catch(error => console.warn("[local-apps] Agent 连接同步失败", error.message)); };
  const timer = gateway ? setInterval(sync, 3000) : undefined;
  timer?.unref(); sync();
  app.once("before-quit", () => { if (timer) clearInterval(timer); });
  const controlAgent = async (id: string, command: "takeover" | "return" | "stop"): Promise<void> => {
    const config = service.get(id);
    if (!gateway || !config.agentPort) throw new Error("此应用尚未连接 Agent Gateway。");
    const profile = gateway.profile(config, await gateway.status());
    if (!profile?.ownerSessionId || profile.sessionStatus !== "active") throw new Error("此应用当前没有 Agent 会话。");
    const result = command === "return"
      ? await profileManager.resumeAgentConnections(localAppProfileId(id), { session: profile.ownerSessionId })
      : await profileManager.takeoverAgentConnections(localAppProfileId(id), { session: profile.ownerSessionId, reason: command === "stop" ? "user_stop" : "user_takeover" });
    if (!result.successCount || result.failures.length) throw new Error(result.failures[0]?.error || "Agent 控制权操作未完成，请刷新后重试。");
    await service.syncAgents();
  };
  const debuggers = new Map<string, BrowserWindow>();
  const backgroundTest = process.env.CPM_E2E_MODE === "background";
  ipcMain.handle(LOCAL_APPS_CHANNEL, async (event, method: string, ...args: unknown[]) => {
    let source = "";
    try { source = fileURLToPath(event.senderFrame!.url.split("?")[0]); } catch { /* reject below */ }
    if (path.resolve(source) !== path.resolve(__dirname, "../../../public/local-apps.html") || event.senderFrame !== event.sender.mainFrame) throw new Error("本地应用接口只能由本地应用工作区调用。");
    if (method === "list") return service.list();
    if (method === "save") { const id = await service.save(args[0] as never); sync(); return id; }
    if (method === "pickDirectory") {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = { title: "选择 Electron 项目文件夹", properties: ["openDirectory"] };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0];
    }
    const id = z.string().uuid().parse(args[0]);
    switch (method) {
      case "remove": return service.remove(id);
      case "start": return service.start(id);
      case "stop": return service.stop(id);
      case "restart": return service.restart(id);
      case "logs": return service.logs(id);
      case "agentControl": return controlAgent(id, z.enum(["takeover", "return", "stop"]).parse(args[1]));
      case "openDirectory": {
        const directory = service.get(id).cwd;
        if (!directory) throw new Error("此应用没有配置项目文件夹。");
        const error = await shell.openPath(directory); if (error) throw new Error(error); return;
      }
      case "openDebugger": {
        const kind = z.enum(["renderer", "main"]).parse(args[1]);
        const targetId = z.string().min(1).max(500).parse(args[2]);
        const url = await service.debuggerUrl(id, kind, targetId);
        if (gateway) {
          const profile = await gateway.activeProfile(service.get(id));
          if (profile?.ownerSessionId && profile.sessionStatus === "active" && profile.ownership === "agent") await controlAgent(id, "takeover");
        }
        const key = `${id}:${kind}:${targetId}`;
        const existing = debuggers.get(key);
        if (existing && !existing.isDestroyed()) {
          if (!backgroundTest) { existing.show(); existing.focus(); }
          return;
        }
        const window = new BrowserWindow({ width: 1100, height: 760, show: !backgroundTest, focusable: !backgroundTest, title: `${service.get(id).name} · ${kind === "main" ? "主进程" : "界面"}调试`, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", event => event.preventDefault());
        debuggers.set(key, window); window.once("closed", () => debuggers.delete(key));
        try { await window.loadURL(url); } catch (error) { window.close(); throw error; }
        return;
      }
      default: throw new Error("未知的本地应用操作。");
    }
  });
  return service;
}
