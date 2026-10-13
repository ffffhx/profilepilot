import { BrowserWindow, ipcMain, net, session } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isWorkspaceShell } from "../workspace-shell";
import { PHONE_CHANNEL, PHONE_CHANGED } from "../../shared/phones";
import { PhonesService } from "./service";
import { executePhoneCommand } from "./management";
import { AndroidSetup } from "./android-setup";
import { desktopCameraCapture } from "./screen-camera-capture";
import { cameraStartSchema } from "./screen-camera";

export function registerPhones(root: string, apkPath: string, poll = true): PhonesService {
  const service = new PhonesService({ root, apkPath, cameraCapture: desktopCameraCapture(), androidSetup: new AndroidSetup({
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    proxy: async () => {
      const route = (await session.defaultSession.resolveProxy("https://dl.google.com/android/repository/repository2-3.xml")).split(";")[0].trim();
      const match = route.match(/^(PROXY|SOCKS5?)\s+([^\s:]+):(\d+)$/);
      return match ? [`--proxy=${match[1] === "PROXY" ? "http" : "socks"}`, `--proxy_host=${match[2]}`, `--proxy_port=${match[3]}`] : [];
    }
  }), onChanged: snapshot => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && trusted(window.webContents.getURL())) window.webContents.send(PHONE_CHANGED, snapshot);
  } });
  ipcMain.handle(PHONE_CHANNEL, async (event, method: string, params: unknown) => {
    const url = event.senderFrame?.url || "";
    if (event.senderFrame !== event.sender.mainFrame || !trusted(url)) throw new Error("手机接口仅供 ProfilePilot 工作区使用。");
    if (method === "snapshot") return service.snapshot();
    if (!trusted(url, true)) throw new Error("请在手机工作区操作设备。");
    if (method === "camera-start") {
      const input = cameraStartSchema.parse(params);
      const owner = event.sender;
      const controller = new AbortController();
      const stop = () => controller.abort();
      const detached = () => owner.removeListener("destroyed", stop);
      owner.once("destroyed", stop);
      try {
        const result = await service.screenCamera.start(input, { signal: controller.signal, detached });
        if (owner.isDestroyed()) { stop(); throw new Error("扫码窗口已关闭"); }
        return result;
      } catch (error) { detached(); throw error; }
    }
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
